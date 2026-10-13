import { db } from './db.js';
export const commerceError=(message,status=400)=>Object.assign(new Error(message),{status});
const offsets={'Asia/Shanghai':480,'Asia/Kuala_Lumpur':480,UTC:0};
export const clockPattern=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function commerceSettings(){return db.prepare('SELECT timezone,open_time AS openTime,close_time AS closeTime,export_title AS exportTitle FROM commerce_settings WHERE id=1').get();}
export function localDateTime(time=Date.now(),timezone=commerceSettings().timezone){return new Date(time+offsets[timezone]*60000).toISOString().slice(0,16);}
export function parseLocal(value,timezone=commerceSettings().timezone) {
  if(!Object.hasOwn(offsets,timezone) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || ''))throw commerceError('请填写有效的起止日期和时间');
  const stamp=Date.parse(value+':00Z');
  if(!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0,16)!==value)throw commerceError('日期无效');
  return stamp-offsets[timezone]*60000;
}
export const nextDate=(date,days=1)=>new Date(parseLocal(date+'T00:00','UTC')+days*86400000).toISOString().slice(0,10);
export function businessWindow(date,settings=commerceSettings()) {
  const start=date+'T'+settings.openTime,end=nextDate(date,settings.closeTime<=settings.openTime?1:0)+'T'+settings.closeTime;
  return checkedWindow(start,end,settings);
}
export function currentBusinessDate(settings=commerceSettings(),time=Date.now()) {
  const local=localDateTime(time,settings.timezone);
  return local.slice(11)<settings.openTime?nextDate(local.slice(0,10),-1):local.slice(0,10);
}
export function checkedWindow(start,end,settings=commerceSettings()) {
  const from=parseLocal(start,settings.timezone),to=parseLocal(end,settings.timezone);
  if(from>=to)throw commerceError('结束时间必须晚于开始时间');
  if(to-from>31*86400000)throw commerceError('一次最多导出 31 天，请缩短时间范围');
  return {start,end,from,to,timezone:settings.timezone,title:settings.exportTitle,filename:`${settings.exportTitle}-${start.replace(/[-:T]/g,'')}-${end.replace(/[-:T]/g,'')}.xlsx`};
}
export function reportWindow(query={},settings=commerceSettings()) {
  if(query.startAt || query.endAt)return checkedWindow(query.startAt,query.endAt,settings);
  if(query.date)return businessWindow(String(query.date),settings);
  if(query.start || query.end) {
    const date=String(query.start || query.end),last=String(query.end || query.start),first=businessWindow(date,settings),end=businessWindow(last,settings);
    return checkedWindow(first.start,end.end,settings);
  }
  return businessWindow(currentBusinessDate(settings),settings);
}
export function utcTime(value) {
  if(!value)return null;
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value)?value:value.replace(' ','T')+'Z');
}
export const inWindow=(value,window)=>{const stamp=utcTime(value);return Number.isFinite(stamp)&&stamp>=window.from&&stamp<window.to;};
export function formatTime(value,timezone=commerceSettings().timezone){const stamp=utcTime(value);return Number.isFinite(stamp)?localDateTime(stamp,timezone).replace('T',' '):'';}
export function saveCommerceSettings(body) {
  const current=commerceSettings(),s={...current,...body};
  if(!Object.hasOwn(offsets,s.timezone)||!clockPattern.test(s.openTime)||!clockPattern.test(s.closeTime)||!String(s.exportTitle).trim()||String(s.exportTitle).length>30||/[\\/:*?"<>|\u0000-\u001f]/.test(s.exportTitle))throw commerceError('营业日时间、时区或导出标题无效');
  db.prepare('UPDATE commerce_settings SET timezone=?,open_time=?,close_time=?,export_title=? WHERE id=1').run(s.timezone,s.openTime,s.closeTime,String(s.exportTitle).trim());return commerceSettings();
}
