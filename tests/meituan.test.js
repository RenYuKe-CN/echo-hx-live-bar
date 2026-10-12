import test from 'node:test';
import assert from 'node:assert/strict';
import { meituanSign, meituanCapability, meituanProvider, meituanDate } from '../server/integrations/meituan.js';

const config={meituan_developer_id:'100567',meituan_sign_key:'fixture',meituan_vendor_shop_id:'shop-1',meituan_erp_id:'erp-1',meituan_erp_name:'顾客自助',meituan_redemption_enabled:'1'};
const coupon={status:10,couponStatus:10,dealType:2,dealId:'9223372036854775800',dealTitle:'双人套餐',realAmount:'89.99',dealValue:'120.00',dealSkuMappingDetail:{count:1,vendorSkus:['whole-package']},dealRuleCouponLimit:-1};
test('Meituan signing matches the official SHA1 example before URL encoding',()=>{
  const parameters={appAuthToken:'74d301d082f366b730043dc0a55b403ac0f7ac9e63c93cedd3ab9759a06a1bbf3fc953de835c',charset:'UTF-8',timestamp:'1577771730',developerId:'100567',biz:'{"ticket":"10346762252","number":2}',version:'2'};
  assert.equal(meituanSign(parameters,'2d11ab8e'),'5f0ca9b258908d507eab3a1ab54f277778f9eff4');
  assert.equal(meituanSign({...parameters,sign:'ignored',empty:''},'2d11ab8e'),meituanSign(parameters,'2d11ab8e'));
});
test('Meituan needs an explicit enable switch and every direct-connect credential',()=>{
  assert.equal(meituanCapability(config).ready,true);
  for(const key of Object.keys(config))assert.equal(meituanCapability({...config,[key]:''}).ready,false,key);
  assert.equal(meituanCapability({...config,meituan_redemption_enabled:'0'}).ready,false);
});
test('Meituan dates use Shanghai time across midnight and preserve validity instants',async()=>{
  assert.equal(meituanDate(Date.parse('2026-10-12T16:00:00Z')),'2026-10-13');
  const provider=meituanProvider(config,async()=>({code:'OP_SUCCESS',data:{...coupon,couponStartTime:'2026-10-12 23:59:59',couponEndTime:'2026-10-13 00:00:00'}}));
  const [voucher]=await provider.prepare('000012345678');
  assert.equal(voucher.restrictions.start,Date.parse('2026-10-12T15:59:59Z')/1000);
  assert.equal(voucher.restrictions.end,Date.parse('2026-10-12T16:00:00Z')/1000);
});
test('only unambiguous unused fixed packages with decimal-yuan amounts can be prepared',async()=>{
  for(const patch of [{status:20},{couponStatus:20},{dealType:1},{timeCardType:1},{receiptChannel:1004},{sqtInfo:{sqtOrder:1}},
    {dealSkuMappingDetail:{count:1,vendorSkus:['a','b']}},{dealSkuMappingDetail:{count:2,vendorSkus:['a','b']}},
    {realAmount:'89.999'},{realAmount:'invalid'},{dealValue:'0.00'},{dealRuleCouponLimit:0},{couponEndTime:'2026-02-30 00:00:00'}]) {
    const provider=meituanProvider(config,async()=>({code:'OP_SUCCESS',data:{...coupon,...patch}}));
    await assert.rejects(()=>provider.prepare('000012345678'),undefined,JSON.stringify(patch));
  }
});
test('platform failures cannot leak raw voucher codes, signatures or arbitrary messages',async()=>{
  const provider=meituanProvider(config,async()=>({code:'DENIED',msg:'secret raw coupon 000012345678'}));
  await assert.rejects(()=>provider.prepare('000012345678'),error=>error.status===503 && !error.message.includes('000012345678'));
});
test('a preflight crossing Shanghai midnight can recover on the following day using the same order',async()=>{
  const dates=[],code='000012345678',orderId='GBMT-fixture';
  const provider=meituanProvider(config,async(url,options)=>{
    if(url.endsWith('status/query'))return {code:'OP_SUCCESS',data:coupon};
    const payload=JSON.parse(new URLSearchParams(options.body).get('biz'));dates.push(payload.date);assert.equal(payload.vendorOrderId,orderId);
    return {code:'OP_SUCCESS',data:{vendorOrderList:payload.date==='2026-10-13'?[{vendorOrderId:orderId,dealInfoList:[{dealId:coupon.dealId,dealType:2,couponCodeList:[code],couponDetailList:[{couponCode:code,couponStatus:10,realAmount:'89.99'}]}]}]:[]}};
  });
  const [voucher]=await provider.prepare(code);voucher.verificationContext={vendorOrderId:orderId,date:'2026-10-12'};
  assert.equal((await provider.reconcile(voucher)).verifyId,orderId);assert.deepEqual(dates,['2026-10-12','2026-10-13']);
});
