import crypto from 'node:crypto';
import { getIntegrationValues } from '../config.js';
const bases={china:'https://api.feieyun.cn/Api/Open/',asia:'https://api.jp.feieyun.com/Api/Open/',europe:'https://api.de.feieyun.com/Api/Open/'};
const failure=(message,definite=false)=>Object.assign(new Error(message),{status:503,definite});
export function feieConfiguration(){const c=getIntegrationValues();return {user:c.feie_user,ukey:c.feie_ukey,region:c.feie_region || 'china',enabled:c.feie_printing_enabled==='1'};}
export function feieStatus(){const c=feieConfiguration();return {ready:c.enabled&&!!(c.user&&c.ukey&&bases[c.region]),configured:!!(c.user&&c.ukey&&bases[c.region]),region:c.region};}
export const feieSign=(user,ukey,stime)=>crypto.createHash('sha1').update(user+ukey+stime,'utf8').digest('hex');
export function feieProvider(expected={}) {
  const c=feieConfiguration();
  if(!feieStatus().ready)throw failure('请先配置飞鹅账号、UKEY、区域并启用云打印',true);
  if((expected.user&&expected.user!==c.user)||(expected.region&&expected.region!==c.region))throw failure('飞鹅账号或区域已变更，请核对原账号的打印记录',true);
  const call=async(action,values)=>{
    const stime=String(Math.floor(Date.now()/1000));
    const body=new URLSearchParams({user:c.user,stime,sig:feieSign(c.user,c.ukey,stime),apiname:'Open_'+action,...values});
    let response,data;
    try {response=await fetch(bases[c.region]+action,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded;charset=utf-8'},body:body.toString(),signal:AbortSignal.timeout(12000)});data=await response.json();}
    catch {throw failure('飞鹅请求结果未确认，请核对任务和打印机出纸情况');}
    if(!response.ok)throw failure('飞鹅请求结果未确认，请稍后查询任务状态');
    if(data?.ret!==0)throw failure('飞鹅未接受请求，请检查账号、设备绑定或接口权限',true);
    return data.data;
  };
  return {
    async bind(printer){
      const result=await call('printerAddlist',{printerContent:`${printer.sn}#${printer.device_key}#${printer.name}`});
      if(!Array.isArray(result?.ok)||!result.ok.some(line=>String(line).split('#')[0]===printer.sn))throw failure('飞鹅未确认此设备绑定成功，请核对设备编号和 KEY',true);
      return true;
    },
    async print(sn,content,{expiresAt}={}){
      if(Buffer.byteLength(content,'utf8')>5000)throw failure('小票内容超过飞鹅单次 5000 字节限制',true);
      const orderId=await call('printMsg',{sn,content,times:'1',...(expiresAt?{expired:String(expiresAt)}:{})});
      if(typeof orderId!=='string'||!orderId)throw failure('飞鹅打印任务回执缺失，请核对出纸情况');
      return orderId;
    },
    async query(orderid){const value=await call('queryOrderState',{orderid});if(typeof value!=='boolean')throw failure('飞鹅返回的打印状态不明确');return value;},
    async printerStatus(sn){const value=await call('queryPrinterStatus',{sn}),states={'离线':0,'在线，工作状态正常':1,'在线，工作状态不正常':2};if(!Object.hasOwn(states,value))throw failure('飞鹅设备状态不明确');return {code:states[value],label:value};}
  };
}
