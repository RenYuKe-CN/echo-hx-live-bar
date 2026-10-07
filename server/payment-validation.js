const mismatch = message => Object.assign(new Error(message), { status: 409, code: 'WECHAT_PAYMENT_MISMATCH' });

export function validateWechatPayment(order, payer, result, values) {
  if (!['wechat', 'mixed'].includes(order.payment_method)
    || result.out_trade_no !== order.order_no
    || result.appid !== values.wechat_app_id || result.mchid !== values.wechat_mch_id
    || !result.transaction_id || !payer?.wechat_openid || result.payer?.openid !== payer.wechat_openid
    || result.amount?.total !== order.wechat_paid_cents || result.amount?.currency !== 'CNY') {
    throw mismatch('微信支付订单、付款人或金额不匹配');
  }
}

export function validateWechatRefund(refund, order, result, values) {
  if (result.out_trade_no !== order.order_no || result.out_refund_no !== refund.out_refund_no
    || result.mchid !== values.wechat_mch_id || !result.refund_id
    || result.amount?.refund !== refund.wechat_cents || result.amount?.total !== order.wechat_paid_cents
    || result.amount?.currency !== 'CNY') throw mismatch('微信退款订单或金额不匹配');
}
