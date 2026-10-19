import { db } from './db.js';
import { catalogError, catalogProduct, componentsFor, logStock } from './catalog.js';

const number = (value, label, fallback, integer = false) => {
  const n = value == null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isSafeInteger(n)) || n > 10000000) throw catalogError(`${label}无效`,400);
  return n;
};
const cents = (v,label,fallback=0) => Math.round(number(v,label,fallback/100)*100);
export function registerCatalogRoutes(router, { audit }) {
  const handled = fn => (req,res) => { try { fn(req,res); } catch(e) { res.status(e.status || 409).json({message:e.message}); } };
  const products = costs => db.prepare('SELECT p.*,c.name AS category FROM products p JOIN categories c ON c.id=p.category_id ORDER BY p.id DESC').all().map(p => catalogProduct(p,costs));
  const impacts = id => db.prepare('SELECT p.id,p.name,bc.quantity FROM bundle_components bc JOIN products p ON p.id=bc.bundle_id WHERE bc.product_id=? ORDER BY p.id').all(id);
  router.get('/admin/products', handled((req,res) => {
    const rows = products(req.staff.role==='super').map(p => ({...p, affectedBundles:p.kind==='basic' ? impacts(p.id) : []}));
    const q = String(req.query.q || '').toLowerCase();
    const filtered = rows.filter(p => (!q || `${p.id} ${p.name} ${p.detail} ${p.category}`.toLowerCase().includes(q)) && (!req.query.kind || p.kind===req.query.kind) && (!req.query.warning || (req.query.warning==='empty' ? p.availableStock===0 : p.warning)));
    const pageSize = Number(req.query.pageSize)===50 ? 50 : 20, totalPages=Math.max(1,Math.ceil(filtered.length/pageSize)), page=Math.min(totalPages,Math.max(1,Number(req.query.page)||1));
    const all = ['1','true'].includes(req.query.all);
    res.json({products:all ? filtered : filtered.slice((page-1)*pageSize,page*pageSize), categories:db.prepare('SELECT * FROM categories ORDER BY sort,id').all(),
      summary:{basic:rows.filter(p=>p.kind==='basic').length,bundles:rows.filter(p=>p.kind==='bundle').length,low:rows.filter(p=>p.warning).length,empty:rows.filter(p=>p.kind==='basic' && !p.availableStock).length,affected:rows.filter(p=>p.kind==='bundle' && !p.availableStock).length},
      pagination:{page,pageSize,total:filtered.length,totalPages,hasPrevious:page>1,hasNext:page<totalPages}});
  }));
  router.get('/admin/products/:id/detail', handled((req,res) => {
    const product = products(req.staff.role==='super').find(p=>p.id===Number(req.params.id));
    if (!product) throw catalogError('商品不存在',404);
    const start=String(req.query.start || ''),end=String(req.query.end || '');
    if ((start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) || (end && !/^\d{4}-\d{2}-\d{2}$/.test(end))) throw catalogError('日期格式无效',400);
    const clauses=['l.product_id=?'],params=[product.id];
    if(start){clauses.push("date(l.created_at,'localtime')>=?");params.push(start);} if(end){clauses.push("date(l.created_at,'localtime')<=?");params.push(end);}
    const logs=db.prepare(`SELECT l.*,o.order_no,t.table_no FROM inventory_logs l LEFT JOIN orders o ON o.id=l.order_id LEFT JOIN table_sessions s ON s.id=o.session_id LEFT JOIN tables t ON t.id=s.table_id WHERE ${clauses.join(' AND ')} ORDER BY l.id DESC LIMIT 500`).all(...params);
    const consumption=db.prepare(`SELECT o.source_channel AS channel,SUM(oi.quantity-oi.returned_quantity-oi.returned_delivered_quantity) AS quantity FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=? AND o.payment_status='paid' AND date(o.paid_at,'localtime')>=date('now','localtime','-29 days') GROUP BY o.source_channel`).all(product.id);
    res.json({product,affectedBundles:impacts(product.id),logs,consumption});
  }));
  router.get('/admin/products/export', handled((req,res) => {
    const quote=v=>`"${String(v??'').replace(/^([=+@-])/,'\t$1').replaceAll('"','""')}"`;
    const rows=products(req.staff.role==='super');
    const header=['货品ID','名称','类型','单位','账面库存','预占','可售','补货线','目标库存','每箱数量','售价',...(req.staff.role==='super'?['成本']:[])];
    const lines=rows.map(p=>[p.id,p.name,p.kind==='bundle'?'套餐':'基础货品',p.unit,p.physicalStock,p.reservedStock,p.availableStock,p.safety_stock,p.target_stock,p.pack_size,p.price,...(req.staff.role==='super'?[p.calculatedCost]:[])]);
    res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="inventory.csv"').send('\uFEFF'+[header,...lines].map(row=>row.map(quote).join(',')).join('\r\n'));
  }));
  const save = (req,res,current) => {
    const b=req.body || {},superAdmin=req.staff.role==='super';
    if (!superAdmin && ['cost','extraCost','referenceCost'].some(k=>b[k]!=null)) throw catalogError('仅超级管理员可配置成本',403);
    const kind=b.kind??current?.kind??'basic';
    if(!['basic','bundle'].includes(kind)) throw catalogError('商品类型无效',400);
    const categoryId=Number(b.categoryId)||current?.category_id;
    const category=categoryId?db.prepare('SELECT * FROM categories WHERE id=?').get(categoryId):db.prepare('SELECT * FROM categories WHERE name=?').get(b.category||'啤酒');
    const name=String(b.name??current?.name??'').trim(),unit=String(b.unit??current?.unit??(kind==='bundle'?'套':'件')).trim();
    if(!name || name.length>80 || !category || !unit || unit.length>8) throw catalogError('请填写有效名称、分类和单位',400);
    const stock=number(b.stock,'库存',current?.stock||0,true),safety=number(b.safetyStock,'补货线',current?.safety_stock??20,true),target=number(b.targetStock,'目标库存',current?.target_stock??100,true),pack=number(b.packSize,'每箱数量',current?.pack_size??1,true);
    if(!pack || target<safety) throw catalogError('每箱数量须大于零，目标库存须不小于补货线',400);
    if(current && stock<current.reserved_stock) throw catalogError(`库存不能低于已预占的 ${current.reserved_stock} 件`);
    const price=cents(b.price,'售价',current?.price_cents),member=b.memberPrice===''?null:b.memberPrice==null?current?.member_price_cents??null:cents(b.memberPrice,'会员价');
    const cost=cents(b.cost,'进货成本',current?.cost_cents),extra=cents(b.extraCost,'附加成本',current?.extra_cost_cents),reference=b.referenceCost===''?null:b.referenceCost==null?current?.reference_cost_cents??null:cents(b.referenceCost,'参考成本');
    const status=b.status??current?.status??'active',sellable=b.sellable==null?current?.sellable??1:['1',1,true].includes(b.sellable)?1:0;
    if(!['active','inactive'].includes(status)) throw catalogError('商品状态无效',400);
    const parts=b.components??(current ? componentsFor(current.id).map(p=>({productId:p.id,quantity:p.component_quantity})) : []);
    if(kind==='bundle') {
      if(!Array.isArray(parts)||!parts.length||parts.length>50 || new Set(parts.map(p=>Number(p.productId))).size!==parts.length) throw catalogError('请选择套餐货品和数量，货品不能重复',400);
      for(const part of parts){const p=db.prepare('SELECT * FROM products WHERE id=?').get(Number(part.productId));if(!p || p.id===current?.id || p.kind!=='basic' || p.store_id!==category.store_id || !Number.isSafeInteger(Number(part.quantity)) || Number(part.quantity)<1 || Number(part.quantity)>999) throw catalogError('套餐仅可关联本店基础货品，数量为 1～999',400);}
    }
    if(current && kind!==current.kind) {
      if(db.prepare('SELECT 1 FROM bundle_components WHERE product_id=?').get(current.id)) throw catalogError('此货品已被套餐使用，不能改成套餐');
      if(db.prepare("SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=? AND o.status IN ('pending_payment','awaiting_delivery')").get(current.id) || db.prepare("SELECT 1 FROM cart_items WHERE product_id=? AND status IN ('pending','checking_out')").get(current.id)) throw catalogError('商品仍在购物车或未完成订单中，请处理后再转换类型');
    }
    const savedProduct=db.transaction(()=>{
      const values=[category.id,name,String(b.detail??current?.detail??''),b.imageUrl??current?.image_url??'',price,member,cost,b.tag??current?.tag??'',b.color??current?.color??'amber',stock,['1',1,true].includes(b.allowBonus??current?.allow_bonus)?1:0,status,kind,unit,sellable,safety,target,pack,extra,reference];
      let id=current?.id;
      if(current) db.prepare('UPDATE products SET category_id=?,name=?,detail=?,image_url=?,price_cents=?,member_price_cents=?,cost_cents=?,tag=?,color=?,stock=?,allow_bonus=?,status=?,kind=?,unit=?,sellable=?,safety_stock=?,target_stock=?,pack_size=?,extra_cost_cents=?,reference_cost_cents=?,auto_unlisted=0 WHERE id=?').run(...values,id);
      else id=db.prepare('INSERT INTO products(store_id,category_id,name,detail,image_url,price_cents,member_price_cents,cost_cents,tag,color,stock,allow_bonus,status,kind,unit,sellable,safety_stock,target_stock,pack_size,extra_cost_cents,reference_cost_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(category.store_id,...values).lastInsertRowid;
      if(current && stock!==current.stock && kind==='basic') logStock(id,stock-current.stock,'编辑商品库存',{operator:req.staff.username});
      if(!current && stock && kind==='basic') logStock(id,stock,'初始库存',{operator:req.staff.username});
      const old=componentsFor(id).map(p=>({productId:p.id,quantity:p.component_quantity}));
      const normalized=kind==='bundle'?parts.map(p=>({productId:Number(p.productId),quantity:Number(p.quantity)})).sort((a,b)=>a.productId-b.productId):[];
      if(JSON.stringify(old)!==JSON.stringify(normalized)) {
        if(current && db.prepare('SELECT 1 FROM group_buy_mappings WHERE product_id=?').get(id))throw catalogError('此套餐已关联平台券。修改组成请新建套餐并关联新的平台套餐 ID，保留旧套餐供历史券兑换');
        db.prepare('DELETE FROM bundle_components WHERE bundle_id=?').run(id);
        normalized.forEach(p=>db.prepare('INSERT INTO bundle_components VALUES(?,?,?)').run(id,p.productId,p.quantity));
        if(current)db.prepare('UPDATE products SET recipe_version=recipe_version+1 WHERE id=?').run(id);
      }
      audit(req,current?'修改商品与套餐':'新增商品与套餐',`${name} #${id}`);
      return catalogProduct(db.prepare('SELECT * FROM products WHERE id=?').get(id),superAdmin);
    })();
    res.status(current?200:201).json({product:savedProduct});
  };
  router.post('/admin/products',handled((req,res)=>save(req,res,null)));
  router.patch('/admin/products/:id',handled((req,res)=>{const p=db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);if(!p)throw catalogError('商品不存在',404);save(req,res,p);}));
  const importRows=rows=>{
    if(!Array.isArray(rows)||!rows.length||rows.length>500||new Set(rows.map(r=>r.productId)).size!==rows.length)throw catalogError('请输入 1～500 条不重复的基础货品',400);
    return rows.map(r=>{const p=db.prepare('SELECT * FROM products WHERE id=?').get(r.productId);if(!p || p.kind!=='basic'||!Number.isSafeInteger(r.productId)||!Number.isSafeInteger(r.stock)||r.stock<0||r.stock<p.reserved_stock)throw catalogError('货品 ID、盘点数量无效，或低于已预占数量',400);return {...r,name:p.name,expectedStock:p.stock,expectedReserved:p.reserved_stock};});
  };
  router.post('/admin/inventory/import/preview',handled((req,res)=>res.json({rows:importRows(req.body?.rows)})));
  router.post('/admin/inventory/import',handled((req,res)=>{
    const reason=String(req.body?.reason || '').trim();if(!reason || reason.length>200)throw catalogError('请填写盘点原因',400);
    db.transaction(()=>{
      const rows=importRows(req.body?.rows);
      for(let i=0;i<rows.length;i++) {const before=req.body.rows[i],row=rows[i];if(before.expectedStock!==row.expectedStock || before.expectedReserved!==row.expectedReserved)throw catalogError(`货品“${row.name}”库存已变化，请重新预览`);}
      for(const row of rows){db.prepare('UPDATE products SET stock=? WHERE id=?').run(row.stock,row.productId);if(row.stock!==row.expectedStock)logStock(row.productId,row.stock-row.expectedStock,`盘点：${reason}`,{operator:req.staff.username});}
      audit(req,'批量盘点库存',`${rows.length} 项：${reason}`);
    })();
    res.json({ok:true});
  }));
}
