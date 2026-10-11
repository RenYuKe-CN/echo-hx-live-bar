import crypto from 'node:crypto';
import { getIntegrationValues } from '../config.js';

let tokenCache;
const error = message => Object.assign(new Error(message), { status:503 });
export function groupBuyCapabilities() {
  const c=getIntegrationValues();
  return {
    meituan:{ready:false,message:'美团自助兑换待开通，请联系服务员核销'},
    douyin:{ready:c.douyin_redemption_enabled==='1' && !!(c.douyin_client_key && c.douyin_client_secret && c.douyin_poi_id),message:'抖音自助兑换待开通，请联系服务员核销'}
  };
}
// Preserve long platform identifiers instead of silently rounding JSON integers.
function parse(text) {
  return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|(-?\d{16,})(?=\s*[,}\]])/g,(all,quoted,number)=>quoted || `"${number}"`));
}
async function request(url, options={}) {
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(12000)});
  const result=parse(await response.text());
  if(!response.ok) throw error('平台请求未确认，请稍后核对');
  return result;
}
async function douyinToken(c) {
  const signature=crypto.createHash('sha256').update(c.douyin_client_key+c.douyin_client_secret).digest('hex');
  if(tokenCache?.signature===signature && tokenCache.until>Date.now())return tokenCache.token;
  const body=await request('https://open.douyin.com/oauth/client_token/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_key:c.douyin_client_key,client_secret:c.douyin_client_secret,grant_type:'client_credential'})});
  const data=body.data;
  if(!data?.access_token || data.error_code) throw error('抖音商户授权不可用，请联系管理员');
  tokenCache={signature,token:data.access_token,until:Date.now()+Math.max(0,Number(data.expires_in)-60)*1000};return data.access_token;
}
export function groupBuyProvider(platform) {
  if(!groupBuyCapabilities()[platform]?.ready)throw error(groupBuyCapabilities()[platform]?.message || '团购平台无效');
  const c=getIntegrationValues();
  const call=async (action,payload,method='GET')=>{
    const token=await douyinToken(c),url=new URL(`https://open.douyin.com/goodlife/v1/fulfilment/certificate/${action}/`);
    if(c.douyin_account_id)payload.account_id=c.douyin_account_id;
    if(method==='GET')Object.entries(payload).forEach(([key,value])=>url.searchParams.set(key,String(value)));
    const response=await request(url,{method,headers:{'content-type':'application/json','access-token':token},...(method==='POST'?{body:JSON.stringify(payload)}:{})});
    if(response.data?.error_code!==0)throw error('平台未确认请求成功，请核对商户授权和券状态');
    return response.data;
  };
  return {
    async prepare(code) {
      const data=await call('prepare',{code,poi_id:c.douyin_poi_id});
      const certificates=data.certificates || data.certificates_v2 || [];
      // Fixed, one-time package vouchers only. Cards and pickup vouchers need
      // a different durable identity for each fulfillment and are excluded.
      return certificates.filter(v=>v.can_verify_status===1 && v.sku?.groupon_type===1).map(v=>{
        const amount=Number(v.amount?.pay_amount);
        if(!Number.isSafeInteger(amount)||amount<0)throw error('平台未返回明确券金额，请由收银台核对');
        if(!data.verify_token || !v.encrypted_code)throw error('平台验券信息不完整，请重新查询');
        return {certificateId:String(v.certificate_id),externalProductId:String(v.sku.sku_id),externalSkuId:String(v.sku.sku_id || ''),name:v.sku.title,
          amountCents:amount,encryptedCode:v.encrypted_code,verifyToken:data.verify_token,expiresAt:Date.now()+5*60000,restrictions:{start:v.start_time,end:v.expire_time,attrs:v.sku.product_attr || {},time:v.use_time_info,unavailable:v.not_available_time_info,offPeak:v.off_peak_discount_info}};
      });
    },
    async verify(voucher) {
      const data=await call('verify',{poi_id:c.douyin_poi_id,verify_token:voucher.verifyToken,encrypted_codes:[voucher.encryptedCode]},'POST');
      const result=data.verify_results?.find(v=>String(v.certificate_id)===voucher.certificateId && v.result===0);
      if(!result?.verify_id)throw error('核销结果待核对，请勿重复兑换');
      return {verifyId:String(result.verify_id),certificateId:String(result.certificate_id)};
    }
  };
}
