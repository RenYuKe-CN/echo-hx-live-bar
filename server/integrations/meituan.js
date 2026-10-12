import crypto from 'node:crypto';

// Restaurant direct-connect (businessId 79), for customer-entered voucher codes.
// API and signing contracts: see docs/MEITUAN-REDEMPTION.md.
const endpoint = 'https://api-open-cater.meituan.com/dishconnect/tuangou/coupon/';
const unavailable = message => Object.assign(new Error(message), { status: 503 });
export const meituanKeys = ['meituan_developer_id', 'meituan_sign_key', 'meituan_vendor_shop_id', 'meituan_erp_id', 'meituan_erp_name'];
export function meituanCapability(config) {
  const configured = meituanKeys.every(key => config[key]);
  const enabled = config.meituan_redemption_enabled === '1';
  return { ready: enabled && configured, message: !enabled ? '美团自助兑换未启用，请联系服务员核销' : !configured ? '美团核销配置尚未完成，请联系服务员核销' : '' };
}
export function meituanSign(parameters, signKey) {
  const text = Object.keys(parameters).sort().filter(key => key.toLowerCase() !== 'sign' && parameters[key] != null && parameters[key] !== '')
    .map(key => key + parameters[key]).join('');
  return crypto.createHash('sha1').update(signKey + text, 'utf8').digest('hex');
}
function money(value) {
  // Amounts in this API are decimal yuan, not cents. Reject malformed amounts
  // instead of rounding or confusing a package's face value with its revenue.
  const text = String(value ?? '');
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(text)) throw unavailable('美团未返回明确券金额，请由收银台核对');
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
function dateSeconds(value) {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw unavailable('美团券有效期需由服务员核对');
  const date = new Date(value.replace(' ', 'T') + '+08:00');
  // Date.parse normalizes invalid days; don't silently accept those dates.
  if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') !== value) throw unavailable('美团券有效期需由服务员核对');
  return date.getTime() / 1000;
}
export const meituanDate = (time = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
const yuan = cents => (cents / 100).toFixed(2);
function voucherFrom(data, code, config) {
  if (data?.status !== 10 || data.couponStatus !== 10) throw unavailable('美团券不可使用，可能已核销、退款、冻结或过期，请核对券详情');
  if (data.dealType !== 2 || data.timeCardType || data.receiptChannel === 1004 || data.sqtInfo?.sqtOrder) throw unavailable('目前仅支持普通固定套餐券，其他券请联系收银台兑换');
  const mapping = data.dealSkuMappingDetail;
  if (mapping?.count !== 1 || !Array.isArray(mapping.vendorSkus) || mapping.vendorSkus.length !== 1 || typeof mapping.vendorSkus[0] !== 'string' || !mapping.vendorSkus[0].trim()) throw unavailable('请先在美团直连配置中将团单关联一个整套收银 SKU；多选套餐请联系收银台');
  if (!data.dealId || !['string', 'number'].includes(typeof data.dealId)) throw unavailable('美团未返回明确套餐 ID，请联系收银台');
  const amountCents = money(data.realAmount), faceValueCents = money(data.dealValue);
  if (!faceValueCents) throw unavailable('美团套餐面额需由收银台核对');
  const limit = data.dealRuleCouponLimit;
  if (limit != null && (!Number.isInteger(limit) || limit < -1 || limit === 0)) throw unavailable('美团套餐使用数量限制需由服务员核对');
  return { certificateId: code, couponCode: code, externalProductId: String(data.dealId), externalSkuId: mapping.vendorSkus[0], name: data.poiDealTitle || data.dealTitle,
    amountCents, faceValueCents, vendorShopId: config.meituan_vendor_shop_id, developerId: config.meituan_developer_id, expiresAt: Date.now() + 5 * 60000,
    restrictions: { start: dateSeconds(data.couponStartTime), end: dateSeconds(data.couponEndTime), attrs: {}, maxPerRedemption: limit > 0 ? limit : undefined } };
}
export function meituanProvider(config, request) {
  async function call(action, payload) {
    const parameters = { businessId: '79', charset: 'utf-8', developerId: config.meituan_developer_id, timestamp: String(Math.floor(Date.now() / 1000)), version: '2', biz: JSON.stringify(payload) };
    parameters.sign = meituanSign(parameters, config.meituan_sign_key);
    let body;
    try { body = await request(endpoint + action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams(parameters).toString() }); }
    catch { throw unavailable('美团请求结果未确认，请稍后核对'); }
    // Never expose arbitrary platform response text, signatures or raw codes.
    if (body?.code !== 'OP_SUCCESS') throw unavailable('美团未确认请求成功，请核对直连权限、门店绑定和券状态');
    return body;
  }
  const checkStore = voucher => {
    if (voucher.vendorShopId !== config.meituan_vendor_shop_id || voucher.developerId !== config.meituan_developer_id) throw unavailable('美团门店配置已变更，请重新查询或由管理员核对原门店记录');
  };
  return {
    async prepare(code) {
      if (!/^\d{4,64}$/.test(code)) throw Object.assign(new Error('请填写美团券详情中的数字核销码，保留开头的 0'), { status: 400 });
      const response = await call('status/query', { couponCode: code, vendorShopId: config.meituan_vendor_shop_id });
      return [voucherFrom(response.data, code, config)];
    },
    verificationContext(voucher, requestId, { id, product }) {
      checkStore(voucher);
      return { vendorShopId: voucher.vendorShopId, vendorOrderId: 'GBMT' + id.replace(/-/g, ''), idempotent: requestId, date: meituanDate(),
        toPayAmount: yuan(voucher.faceValueCents), orderSkus: [{ vendorSkuId: voucher.externalSkuId, vendorSkuName: product.name, unit: product.unit, unitPrice: yuan(voucher.faceValueCents), count: 1 }],
        couponCodes: [voucher.couponCode], erpId: config.meituan_erp_id, erpName: config.meituan_erp_name };
    },
    async verify(voucher) {
      const context = voucher.verificationContext;
      // Failures before batchConsume cannot have consumed the voucher here.
      // Release local reservations then; after dispatch, keep ambiguous holds.
      try {
        checkStore(voucher);
        const response = await call('status/query', { couponCode: voucher.couponCode, vendorShopId: voucher.vendorShopId });
        const current = voucherFrom(response.data, voucher.couponCode, config);
        if (current.externalProductId !== voucher.externalProductId || current.externalSkuId !== voucher.externalSkuId || current.amountCents !== voucher.amountCents || current.faceValueCents !== voucher.faceValueCents) throw unavailable('美团套餐或金额已变化，请重新查询券码');
        if (!context || context.idempotent == null) throw unavailable('美团核销请求信息不完整，请重新查询');
        const { date, idempotent, ...prepare } = context;
        await call('batchPrepare', prepare);
      } catch (error) { error.redemptionRejected = true; throw error; }
      const { date, ...payload } = context;
      const response = await call('batchConsume', payload);
      const data = response.data;
      if (data?.couponCodeInfoList?.length !== 1 || data.couponCodeInfoList[0].couponCode !== voucher.couponCode || money(data.toPayAmount) !== voucher.faceValueCents) throw unavailable('美团核销回执不完整，请核对结果');
      // This endpoint returns consumed codes, not a separate verify_id.
      return { certificateId: voucher.certificateId, verifyId: context.vendorOrderId, vendorOrderId: context.vendorOrderId, evidenceType: 'consume_receipt', traceId: response.traceId || '' };
    },
    async reconcile(voucher) {
      checkStore(voucher);
      const context = voucher.verificationContext;
      if (!context?.vendorOrderId || !context.date) return null;
      // Preflight can straddle midnight. Check the following Shanghai day too,
      // still using the original order ID rather than searching arbitrary orders.
      const dates=[context.date,meituanDate(Date.parse(context.date+'T00:00:00+08:00')+86400000)];
      for (const date of dates) {
        const response = await call('queryLocalListByDate', { vendorShopId: voucher.vendorShopId, vendorOrderId: context.vendorOrderId, date, offset: 0, limit: 1 });
        const order = response.data?.vendorOrderList?.find(order => order.vendorOrderId === context.vendorOrderId);
        const deal = order?.dealInfoList?.find(deal => String(deal.dealId) === voucher.externalProductId && deal.dealType === 2);
        const coupon = deal?.couponDetailList?.find(coupon => coupon.couponCode === voucher.couponCode && coupon.couponStatus === 10);
        if (!coupon || !deal.couponCodeList?.includes(voucher.couponCode) || money(coupon.realAmount) !== voucher.amountCents) continue;
        // A used status from status/query alone cannot prove *our* order consumed it.
        return { certificateId: voucher.certificateId, verifyId: context.vendorOrderId, vendorOrderId: context.vendorOrderId, evidenceType: 'local_history', traceId: response.traceId || '' };
      }
      return null;
    }
  };
}
