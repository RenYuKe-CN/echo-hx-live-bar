import crypto from 'node:crypto';
import { db } from './db.js';
import { assertStock } from './catalog.js';
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
export function registerTableSelection(router, { requireWechatUser, currentUserId, getOrCreateSession }) {
  router.get('/tables', requireWechatUser, (_req, res) => res.json({ tables: db.prepare(`SELECT t.id,t.table_no AS tableNo,
    EXISTS(SELECT 1 FROM table_sessions s WHERE s.table_id=t.id AND s.status='open') AS occupied
    FROM tables t WHERE t.status!='disabled' ORDER BY t.table_no`).all().map(t => ({...t,occupied:!!t.occupied})) }));
  router.post('/tables/select', requireWechatUser, (req, res) => {
    try {
      const result = db.transaction(() => {
        const userId = currentUserId(req), { tableId, currentSessionId = null, cartAction = 'keep', requestId, confirmed = false } = req.body || {};
        if (!Number.isSafeInteger(tableId) || typeof confirmed!=='boolean' || (currentSessionId!=null && (!Number.isSafeInteger(currentSessionId) || currentSessionId<1)) || !['keep','move'].includes(cartAction) || !/^[a-f0-9-]{36}$/i.test(String(requestId || ''))) fail('选桌参数无效，请重试', 400);
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify([tableId,currentSessionId,cartAction,confirmed])).digest('hex');
        const prior = db.prepare('SELECT * FROM table_switch_commands WHERE request_id=?').get(requestId);
        if (prior) {
          if (prior.user_id !== userId || prior.fingerprint !== fingerprint) fail('请求标识已使用');
          const session = db.prepare("SELECT * FROM table_sessions WHERE id=? AND status='open'").get(prior.session_id);
          if (!session) fail('选中的桌台已结束，请重新选择');
          return { session, table: { id:tableId,tableNo:db.prepare('SELECT table_no FROM tables WHERE id=?').get(tableId)?.table_no }, repeated:true };
        }
        const table = db.prepare("SELECT * FROM tables WHERE id=? AND status!='disabled'").get(tableId);
        if (!table) fail('桌台不存在或已停用', 404);
        const old = currentSessionId ? db.prepare('SELECT s.* FROM table_sessions s JOIN session_members m ON m.session_id=s.id WHERE s.id=? AND m.user_id=?').get(currentSessionId,userId) : null;
        if (currentSessionId && !old) fail('原桌台未加入，请重新加载', 403);
        const target = db.prepare("SELECT * FROM table_sessions WHERE table_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(tableId);
        if (target && target.id !== old?.id && !confirmed) fail('该桌正在使用，请确认自己已在此桌就座', 409);
        // Pending payments remain authoritative until the payment query/cancel path resolves them.
        if (db.prepare("SELECT 1 FROM orders WHERE payer_user_id=? AND payment_status='pending' AND session_id!=?").get(userId,target?.id || -1)) fail('原桌有待支付订单，请到我的订单完成支付或取消后再切换');
        const session = getOrCreateSession(table.store_id,table.id,userId);
        if (cartAction === 'move' && old && old.id !== session.id) {
          const own = db.prepare("SELECT * FROM cart_items WHERE session_id=? AND added_by_user_id=? AND status='pending'").all(old.id,userId);
          const existing = db.prepare("SELECT product_id,quantity FROM cart_items WHERE session_id=? AND status='pending'").all(session.id);
          assertStock([...existing,...own]);
          for (const item of own) {
            if (!db.prepare("SELECT 1 FROM products WHERE id=? AND status='active' AND sellable=1").get(item.product_id)) fail('购物车有下架商品，请先处理后再移动');
            if (item.applied_coupon_id && db.prepare("SELECT 1 FROM cart_items WHERE session_id=? AND applied_coupon_id=? AND status='pending'").get(session.id,item.applied_coupon_id)) fail('目标桌已有同一张商品券，请先核对');
            db.prepare('UPDATE cart_items SET session_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(session.id,item.id);
          }
        }
        db.prepare('INSERT INTO table_switch_commands(request_id,user_id,fingerprint,session_id) VALUES(?,?,?,?)').run(requestId,userId,fingerprint,session.id);
        return { table:{id:table.id,tableNo:table.table_no},session };
      })();
      res.json(result);
    } catch (error) { res.status(error.status || 409).json({ message:error.message }); }
  });
}
